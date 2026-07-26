import { guessService, listDomains, messagesByDomain } from "./intake";
import { shareUrlByMailbox } from "./store";
import type { DomainStat, Env, IntakeMessage, MailboxStat, Overview } from "./types";

export async function domainStats(env: Env): Promise<DomainStat[]> {
  const domains = await listDomains(env);
  const stats = await Promise.all(
    domains.map(async ({ domain, enabled }) => {
      const messages = await messagesByDomain(env, domain).catch(() => [] as IntakeMessage[]);
      const mailboxes = new Set<string>();
      let codes = 0;
      let lastActivity: string | null = null;
      for (const m of messages) {
        if (m.recipient) mailboxes.add(m.recipient.toLowerCase());
        if (m.code) codes += 1;
        const at = m.received_at ?? "";
        if (at && (!lastActivity || at > lastActivity)) lastActivity = at;
      }
      return {
        domain,
        enabled,
        mailboxes: mailboxes.size,
        messages: messages.length,
        codes,
        lastActivity,
      } satisfies DomainStat;
    }),
  );
  return stats.sort((a, b) => String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")) || a.domain.localeCompare(b.domain));
}

export async function mailboxStats(env: Env, domain: string, origin: string): Promise<MailboxStat[]> {
  const [messages, shared] = await Promise.all([
    messagesByDomain(env, domain).catch(() => [] as IntakeMessage[]),
    shareUrlByMailbox(env, origin),
  ]);

  const grouped = new Map<string, IntakeMessage[]>();
  for (const m of messages) {
    const key = String(m.recipient ?? "").toLowerCase();
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), m]);
  }

  return [...grouped.entries()]
    .map(([mailbox, list]) => {
      list.sort((a, b) => String(b.received_at ?? "").localeCompare(String(a.received_at ?? "")));
      const latest = list[0];
      const withCode = list.find((m) => m.code);
      const shareUrl = shared.get(mailbox);
      return {
        mailbox,
        localPart: mailbox.split("@")[0] ?? mailbox,
        domain,
        messages: list.length,
        lastCode: withCode?.code ?? null,
        lastActivity: latest?.received_at ?? null,
        service: guessService(latest?.sender, latest?.subject),
        shared: Boolean(shareUrl),
        shareUrl,
      } satisfies MailboxStat;
    })
    .sort((a, b) => String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")));
}

export async function overview(env: Env, origin: string, links: number): Promise<Overview> {
  const domains = await domainStats(env);
  const withMail = domains.filter((d) => d.mailboxes > 0);
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  const perDomain = await Promise.all(
    withMail.map(async (d) => {
      const msgs = await messagesByDomain(env, d.domain).catch(() => [] as IntakeMessage[]);
      let todayCodes = 0;
      let weekCodes = 0;
      for (const m of msgs) {
        if (!m.code) continue;
        const at = String(m.received_at ?? "");
        if (at.startsWith(today)) todayCodes += 1;
        const ts = Date.parse(at);
        if (Number.isFinite(ts) && now - ts < 7 * 86400_000) weekCodes += 1;
      }
      return { todayCodes, weekCodes };
    }),
  );

  const lastActivity = domains.reduce<string | null>(
    (acc, d) => (d.lastActivity && (!acc || d.lastActivity > acc) ? d.lastActivity : acc),
    null,
  );

  return {
    mailboxesTotal: domains.reduce((n, d) => n + d.mailboxes, 0),
    codesToday: perDomain.reduce((n, x) => n + x.todayCodes, 0),
    codesWeek: perDomain.reduce((n, x) => n + x.weekCodes, 0),
    shareLinks: links,
    lastActivity,
    domainsWithMail: withMail.length,
    domainsConfigured: domains.length,
    topDomains: withMail.slice(0, 6),
  };
}
