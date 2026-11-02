import { headers } from "next/headers";
import { TOKEN_STASH_SCRIPT } from "@/lib/observatory/token-page";

/** 確認・配信停止の頁の先頭に置く inline script。解析の script より前に # を URL から消す（token-page.ts）。 */
export async function TokenStashScript() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: TOKEN_STASH_SCRIPT }} />;
}
