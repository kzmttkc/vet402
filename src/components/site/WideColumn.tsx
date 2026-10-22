/** 1024px 以上で紙・ヘッダ・フッタの列を 1200px にする。トップと同じ。 */
export function WideColumn() {
  return <style>{`@media (min-width: 1024px) { :root { --column: 1200px; } }`}</style>;
}
