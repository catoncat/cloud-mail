import { domainCounters, guessService, listDomains, messagesByDomain } from "./intake";
import { shareUrlByMailbox } from "./store";
import type { DomainStat, Env, IntakeMessage, MailboxStat, Overview } from "./types";

/** One aggregate query, not one message fetch per domain. */
export async function domainStats(env: Env): Promise<DomainStat[]> {
  const [domains, counters] = await Promise.all([
    listDomains(env),
    domainCounters(env).catch(() => new Map()),
  ]);

  const stats = domains.map(({ domain, enabled }) => {
    const c = counters.get(domain);
    return {
      domain,
      enabled,
      mailboxes: c?.mailboxes ?? 0,
      messages: c?.messages ?? 0,
      codes: c?.codes ?? 0,
      lastActivity: c?.lastActivity ?? null,
    } satisfies DomainStat;
  });

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
  const [domains, counters] = await Promise.all([
    domainStats(env),
    domainCounters(env).catch(() => new Map()),
  ]);
  const withMail = domains.filter((d) => d.mailboxes > 0);

  let codesToday = 0;
  let codesWeek = 0;
  for (const c of counters.values()) {
    codesToday += c.codesToday;
    codesWeek += c.codesWeek;
  }

  const lastActivity = domains.reduce<string | null>(
    (acc, d) => (d.lastActivity && (!acc || d.lastActivity > acc) ? d.lastActivity : acc),
    null,
  );

  return {
    mailboxesTotal: domains.reduce((n, d) => n + d.mailboxes, 0),
    codesToday,
    codesWeek,
    shareLinks: links,
    lastActivity,
    domainsWithMail: withMail.length,
    domainsConfigured: domains.length,
    topDomains: withMail.slice(0, 6),
  };
}
