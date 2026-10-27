import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { IssuanceView } from "@/lib/targets";
import { Stamp } from "../stamp";

export function Issuances({
  issuances,
  now,
  showProject,
}: {
  issuances: IssuanceView[];
  now: string;
  showProject: boolean;
}) {
  if (issuances.length === 0) {
    return <p className="text-sm text-muted-foreground">No credentials issued yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issued</TableHead>
          {showProject && <TableHead>Project</TableHead>}
          <TableHead>Tier</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>To</TableHead>
          <TableHead>Expires</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {issuances.map((issuance) => (
          <TableRow key={issuance.id}>
            <TableCell>
              <Stamp at={issuance.issuedAt} now={now} />
            </TableCell>
            {showProject && (
              <TableCell className="font-mono text-xs">{issuance.project ?? "—"}</TableCell>
            )}
            <TableCell className="capitalize">{issuance.tier}</TableCell>
            <TableCell className="font-mono text-xs">{issuance.target}</TableCell>
            <TableCell>
              {issuance.runUrl ? (
                <a
                  href={issuance.runUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-4 hover:underline focus-visible:underline"
                >
                  {issuance.by}
                </a>
              ) : (
                issuance.by
              )}
            </TableCell>
            <TableCell>
              <Stamp at={issuance.expiresAt} now={now} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
