import type { CSSProperties, ReactNode } from "react";
import { Box, DataList, Flex, Grid, Table, Text, Theme } from "@radix-ui/themes";
import { lightAccent } from "../theme.ts";
import type { Invoice } from "../api.ts";
import { Link } from "../router.tsx";
import { formatDay } from "../timer.tsx";
import { Card, SrOnly, TableRegion } from "../ui.tsx";
import { formatMoney, formatQuantity } from "../../shared/money.ts";
import { isIsoDate } from "../../shared/time.ts";

export type From = { name: string; address: string; logoVersion: number | null };
export type PaperInvoice = Pick<
  Invoice,
  "number" | "issueDate" | "dueDate" | "poNumber" | "subject" | "periodFrom" | "periodTo" | "currency" | "notes"
  | "subtotal" | "discount" | "tax" | "total" | "discountBasisPoints" | "taxBasisPoints" | "taxLabel"
> & { client: { name: string; address: string; email: string } };

export const longDate = (d: string) => formatDay(d, { day: "numeric", month: "long", year: "numeric" });
// The preview shows a date box that's still being typed in as a dash.
const dateText = (d: string) => (isIsoDate(d) ? longDate(d) : "—");

/**
 * The invoice as the client sees it, and as it prints: who it's from and for, its number and
 * dates, the lines, the totals and the notes. The invoice page passes editable line rows; the
 * new-invoice screen passes read-only ones for its preview. It stands for the printed or PDF
 * invoice, so it is always light, in dark mode too, with the organization's accent (its light shades).
 */
export function InvoicePaper({ invoice, from, heading, lines, lineCount, empty, actionsColumn = false, afterLines, addressHint = false }: {
  invoice: PaperInvoice;
  from: From;
  /** "Invoice": the page's heading on the invoice page, a level below on the preview. */
  heading: ReactNode;
  lines: ReactNode;
  lineCount: number;
  empty: string;
  actionsColumn?: boolean;
  afterLines?: ReactNode;
  addressHint?: boolean;
}) {
  const money = (cents: number) => formatMoney(cents, invoice.currency);
  return (
    <Theme appearance="light" hasBackground={false} style={lightAccent() as CSSProperties}>
    <Card asChild padded className="wl-invoice">
      <article>
        <Flex direction="column" gap="6">
          <Flex wrap="wrap" justify="between" gap="6">
            <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
              {from.logoVersion ? <img src={`/api/logo?v=${from.logoVersion}`} alt={from.name} className="wl-invoice-logo" /> : <Text size="5" weight="medium">{from.name}</Text>}
              {from.logoVersion && <Text weight="medium">{from.name}</Text>}
              {from.address && <Text size="2" color="gray" style={{ whiteSpace: "pre-line" }}>{from.address}</Text>}
            </Flex>
            <Box>
              {heading}
              <DataList.Root size="2" className="wl-details">
                <DataList.Item>
                  <DataList.Label>Number</DataList.Label>
                  <DataList.Value className="wl-num">{invoice.number}</DataList.Value>
                </DataList.Item>
                {invoice.poNumber && (
                  <DataList.Item>
                    <DataList.Label>PO number</DataList.Label>
                    <DataList.Value className="wl-num">{invoice.poNumber}</DataList.Value>
                  </DataList.Item>
                )}
                <DataList.Item>
                  <DataList.Label>Issued</DataList.Label>
                  <DataList.Value>{dateText(invoice.issueDate)}</DataList.Value>
                </DataList.Item>
                <DataList.Item>
                  <DataList.Label>Due</DataList.Label>
                  <DataList.Value>{dateText(invoice.dueDate)}</DataList.Value>
                </DataList.Item>
              </DataList.Root>
            </Box>
          </Flex>

          <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="5">
            <Box>
              <Text as="p" size="1" weight="medium" color="gray" mb="1" className="wl-eyebrow">Bill to</Text>
              <Text as="p" weight="medium">{invoice.client.name}</Text>
              {invoice.client.address && <Text as="p" size="2" style={{ whiteSpace: "pre-line" }}>{invoice.client.address}</Text>}
              {invoice.client.email && <Text as="p" size="2" color="gray">{invoice.client.email}</Text>}
              {addressHint && invoice.client.name && !invoice.client.address && (
                <Text as="p" size="2" color="gray" className="wl-no-print">
                  <Link to="/clients" className="wl-link">Add the client's address</Link> to show it here.
                </Text>
              )}
            </Box>
            {(invoice.periodFrom || invoice.periodTo) && (
              <Box className="wl-for-work">
                <Text as="p" size="1" weight="medium" color="gray" mb="1" className="wl-eyebrow">For work</Text>
                <Text as="p" size="2">
                  {invoice.periodFrom ? dateText(invoice.periodFrom) : "Up"} – {invoice.periodTo ? dateText(invoice.periodTo) : "now"}
                </Text>
              </Box>
            )}
          </Grid>

          {invoice.subject && <Text as="p" size="3" weight="medium" style={{ overflowWrap: "anywhere" }}>{invoice.subject}</Text>}

          <div>
            <TableRegion label="Invoice lines" minWidth="34rem">
              <Table.Root variant="ghost" size="2">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Description</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end" style={{ width: "6rem" }}>Qty</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end" style={{ width: "8rem" }}>Rate</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end" style={{ width: "8rem" }}>Amount</Table.ColumnHeaderCell>
                    {actionsColumn && <Table.ColumnHeaderCell justify="end" className="wl-no-print" style={{ width: "11rem" }}><SrOnly>Actions</SrOnly></Table.ColumnHeaderCell>}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {lines}
                  {lineCount === 0 && (
                    <Table.Row>
                      <Table.Cell colSpan={5} justify="center"><Text color="gray">{empty}</Text></Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Root>
            </TableRegion>
          </div>
          {afterLines}

          <DataList.Root size="2" className="wl-totals">
            <DataList.Item>
              <DataList.Label>Subtotal</DataList.Label>
              <DataList.Value className="wl-num">{money(invoice.subtotal)}</DataList.Value>
            </DataList.Item>
            {invoice.discount > 0 && (
              <DataList.Item>
                <DataList.Label>Discount{invoice.discountBasisPoints > 0 && ` (${invoice.discountBasisPoints / 100}%)`}</DataList.Label>
                <DataList.Value className="wl-num">{money(-invoice.discount)}</DataList.Value>
              </DataList.Item>
            )}
            {invoice.taxBasisPoints > 0 && (
              <DataList.Item>
                <DataList.Label>{invoice.taxLabel} ({invoice.taxBasisPoints / 100}%)</DataList.Label>
                <DataList.Value className="wl-num">{money(invoice.tax)}</DataList.Value>
              </DataList.Item>
            )}
            <DataList.Item className="wl-grand-total">
              <DataList.Label>Total</DataList.Label>
              <DataList.Value className="wl-num">{money(invoice.total)}</DataList.Value>
            </DataList.Item>
          </DataList.Root>

          {invoice.notes && <Text as="p" size="2" color="gray" className="wl-invoice-notes" style={{ whiteSpace: "pre-line" }}>{invoice.notes}</Text>}
        </Flex>
      </article>
    </Card>
    </Theme>
  );
}

/** A line as it reads on the invoice, without controls. */
export function PaperLine({ line, currency }: { line: { description: string; quantity: number; unitPrice: number; amount: number }; currency: string }) {
  return (
    <Table.Row align="center">
      <Table.RowHeaderCell style={{ overflowWrap: "anywhere" }}>{line.description}</Table.RowHeaderCell>
      <Table.Cell justify="end" className="wl-num">{formatQuantity(line.quantity)}</Table.Cell>
      <Table.Cell justify="end" className="wl-num">{formatMoney(line.unitPrice, currency)}</Table.Cell>
      <Table.Cell justify="end" className="wl-num">{formatMoney(line.amount, currency)}</Table.Cell>
    </Table.Row>
  );
}
