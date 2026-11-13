// Monta o e-mail de proposta concluída. Contém SOMENTE dados operacionais:
// referência da operação, número de adesão, status e data/hora. Nenhum dado do cliente.

export type CompletionNotice = {
  notification_id: string;
  attempt: number;
  recipient_email: string;
  operation_ref: string;
  adhesion_number: string;
  result_status: string;
  completed_at: string;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function formatBrDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function buildCompletionEmail(n: CompletionNotice) {
  const when = formatBrDateTime(n.completed_at);
  const rows: [string, string][] = [
    ["Operação", n.operation_ref],
    ["Número de adesão", n.adhesion_number],
    ["Status", n.result_status],
    ["Concluída em", when],
  ];
  const subject = `Proposta concluída — ${n.operation_ref}`;
  const text = [
    "Fulltime Intelligent Consig",
    "",
    "A proposta foi gerada com sucesso.",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Mensagem automática. Não responda.",
  ].join("\n");
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f4;font-family:Segoe UI,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #ddd">
<tr><td style="background:#111;color:#fff;padding:16px 24px;font-size:14px;letter-spacing:.08em">FULLTIME INTELLIGENT CONSIG</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 16px;font-size:16px">A proposta foi gerada com sucesso.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 24px 6px 0;color:#555">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(v)}</td></tr>`).join("\n")}
</table></td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#777;font-size:12px">Mensagem automática. Não responda.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
