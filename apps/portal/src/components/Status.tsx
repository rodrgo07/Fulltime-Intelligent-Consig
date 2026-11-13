import { STATUS_LABEL, STATUS_TONE, type RequestStatus } from "@fic/contracts";

export function Status({ status }: { status: RequestStatus }) {
  return (
    <span className="status" data-tone={STATUS_TONE[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export const fmtDateTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(iso))
    : "—";
