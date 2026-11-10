import Link from "next/link";
import { TableScroll } from "@/components/site/TableScroll";
import type { ReportBlock, ReportDocument, ReportInline } from "@/lib/reports/markdown";

function vet402Path(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.hostname === "vet402.com" || u.hostname === "www.vet402.com") {
      return u.pathname + u.search;
    }
  } catch {
    return null;
  }
  return null;
}

function InlineNodes({ nodes }: { nodes: ReportInline[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <InlineNode key={i} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: ReportInline }) {
  switch (node.kind) {
    case "text":
      return <>{node.value}</>;
    case "bold":
      return (
        <strong>
          <InlineNodes nodes={node.children} />
        </strong>
      );
    case "code":
      return <code>{node.value}</code>;
    case "link": {
      const path = vet402Path(node.href);
      if (path) {
        return (
          <Link href={path} className="doc-link">
            {node.href}
          </Link>
        );
      }
      return (
        <a href={node.href} className="doc-link">
          {node.href}
        </a>
      );
    }
  }
}

function ReportBlockView({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="doc-p">
          <InlineNodes nodes={block.inlines} />
        </p>
      );
    case "list":
      return (
        <ul className="doc-p list-disc space-y-2 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <TableScroll label={block.headers.join(", ")}>
          <table className="fact-table">
            <thead>
              <tr>
                {block.headers.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={ci > 0 ? "num" : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      );
  }
}

export function ReportMarkdownBody({ doc }: { doc: ReportDocument }) {
  return (
    <>
      {doc.preamble.map((block, i) => (
        <ReportBlockView key={`p-${i}`} block={block} />
      ))}
      {doc.sections.map((section) => (
        <section key={section.heading}>
          <h2 className="sec-head mt-8">
            <span>{section.heading}</span>
          </h2>
          {section.blocks.map((block, i) => (
            <ReportBlockView key={`${section.heading}-${i}`} block={block} />
          ))}
        </section>
      ))}
    </>
  );
}
