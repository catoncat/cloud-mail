import { domainCounters, guessService, listDomains, mailboxSummaries } from "./intake";
import { shareUrlByMailbox } from "./store";
import type { DomainStat, Env, MailboxStat, Overview } from "./types";

/** One aggregate query, not one message fetch per domain. */
export async function domainStats(env: Env): Promise<DomainStat[]> {
  const [domains, counters] = await Promise.all([
    listDomains(env),
    domainCounters(env),
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

/**
 * The address book for one domain.
 *
 * Built from intake's per-recipient aggregate, not from a page of messages: this
 * used to pull 500 whole messages (bodies included) over the binding just to count
 * them, which is both the most expensive query the console could make and a wrong
 * count the moment a domain had more mail than the page held. The aggregate is one
 * GROUP BY, already cached for five minutes, and its numbers are the real ones.
 */
export async function mailboxStats(env: Env, domain: string, origin: string): Promise<MailboxStat[]> {
  const [summaries, shared] = await Promise.all([
    mailboxSummaries(env),
    shareUrlByMailbox(env, origin),
  ]);

  return summaries
    .filter((s) => s.domain === domain)
    .map((s) => {
      const shareUrl = shared.get(s.mailbox);
      return {
        mailbox: s.mailbox,
        localPart: s.localPart,
        domain: s.domain,
        messages: s.messages,
        lastCode: s.lastCode,
        lastActivity: s.lastActivity,
        service: guessService(s.latestSender, s.latestSubject),
        shared: Boolean(shareUrl),
        shareUrl,
      } satisfies MailboxStat;
    })
    .sort((a, b) => String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")));
}

export async function overview(env: Env, origin: string, links: number): Promise<Overview> {
  const [domains, counters] = await Promise.all([
    domainStats(env),
    domainCounters(env),
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
