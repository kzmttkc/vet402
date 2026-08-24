// ============================================================
// vet402 — 3パッケージに重複している検証用正規表現の同一性 (2026-08-22)
//
// WHY THIS EXISTS. `WALLET_RE` / `TX_HASH_RE` / `AGENT_ID_RE` は
// packages/sdk・packages/middleware・packages/mcp-server に別々に書かれている。
// これは「呼ぶ前に弾く」ための門であって、片方だけが緩む・厳しくなると、
// 同じアドレスが SDK では通り MCP では弾かれる（あるいはその逆）という
// 静かな食い違いになる。金の経路の入口が製品ごとに違うのは事実上のバグ。
//
// WHY NOT DEDUPLICATE INSTEAD. mcp-server を sdk に依存させれば1本にできるが、
// このリポは npm workspaces を使っておらず（root package.json に workspaces
// フィールドが無い）、各パッケージが自前の package-lock.json を持つ。
// つまり mcp-server から見た @vet402/sdk は **レジストリ上の公開版** に
// なり、ローカルの src とずれ得る。公開バイナリ（bin: vet402-mcp）の依存を
// 増やすリスクに対して、得られるのは3行の削減でしかない。
// 依存を足さずに意図を明示する方が安全なので、「同一であること」を検査する。
//
// 比較は TypeScript コンパイラ API で AST から正規表現リテラルを取り出す
// 構造的なもの。ソース本文への正規表現照合ではないので、整形やコメントの
// 変更で偽陰性にならない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

/** 同じ検証を書いている場所。1つでも増えたらここに足す。 */
const SOURCES = [
  "packages/sdk/src/index.ts",
  "packages/sdk/src/spend-guard.ts",
  "packages/middleware/src/core.ts",
  "packages/mcp-server/src/vouch-client.ts",
];

/** ファイル内の `const NAME = /…/;` を名前→リテラル文字列で集める。 */
function regexLiterals(rel: string): Map<string, string> {
  const file = join(ROOT, rel);
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.initializer.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      found.set(node.name.text, node.initializer.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

const literals = new Map(SOURCES.map((rel) => [rel, regexLiterals(rel)]));

test("抽出器が実際に正規表現を読めている (空で緑にならない)", () => {
  for (const rel of SOURCES) {
    const found = literals.get(rel)!;
    assert.ok(
      found.has("WALLET_RE"),
      `${rel} から WALLET_RE を AST で取り出せていない — 抽出器が壊れているか、` +
        "名前が変わった (変わったならこのテストの SOURCES と期待値も直すこと)",
    );
  }
});

for (const name of ["WALLET_RE", "TX_HASH_RE", "AGENT_ID_RE"]) {
  test(`${name} が定義されている全パッケージで同一である`, () => {
    const defined = SOURCES.filter((rel) => literals.get(rel)!.has(name)).map(
      (rel) => [rel, literals.get(rel)!.get(name)!] as const,
    );
    assert.ok(defined.length > 0, `${name} がどこにも無い`);

    const [firstFile, expected] = defined[0];
    for (const [rel, actual] of defined) {
      assert.equal(
        actual,
        expected,
        `${name} が食い違っている: ${firstFile} は ${expected}、${rel} は ${actual}。` +
          "同じ入口が製品ごとに違う判定をすると、SDK で通ったアドレスが MCP で" +
          "弾かれる (あるいはその逆) 事故になる。",
      );
    }
  });
}

test("ウォレット正規表現は実際に正しいものだけを通す", () => {
  // 同一であることだけを見ると「全員そろって間違っている」を見逃すので、
  // 中身そのものも1回押さえる。
  const source = literals.get("packages/sdk/src/index.ts")!.get("WALLET_RE")!;
  const re = new RegExp(source.slice(1, source.lastIndexOf("/")));
  assert.ok(re.test("0x" + "a".repeat(40)));
  assert.ok(re.test("0x" + "A".repeat(40)));
  assert.ok(!re.test("0x" + "a".repeat(39)), "39桁を通してはいけない");
  assert.ok(!re.test("0x" + "a".repeat(41)), "41桁を通してはいけない");
  assert.ok(!re.test("a".repeat(40)), "0x 無しを通してはいけない");
  assert.ok(!re.test("0x" + "g".repeat(40)), "16進以外を通してはいけない");
});
