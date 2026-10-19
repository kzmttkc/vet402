import { test } from "node:test";
import assert from "node:assert/strict";
import { sortAnswerShape, sortAnswerShapeCaught, sortAnswerShapeFromRun, type AnswerShapeSort, type AnswerShapeSortRow } from "../src/lib/observatory/answer-shape-sort";

// 2026-09-15〜10-15 の 68 件（人が 2026-10-18 に仕分けたもの）。本文の頭と、クエリ・本文を送ったかだけ。
// 売り手の名前も、売り手の経路も、固有の文言も書かない。件数 n は同じ形の行数。
// human が関数と違う行だけ diverge に理由を書く。段S1b と段S1c で unknown に移った行は、vet402 の誤りと示せないため。

type Human = AnswerShapeSort;
type Case = {
  n: number;
  human: Human;
  /** 関数の結果。人と違うときだけ human と異なる。 */
  expect: AnswerShapeSort;
  diverge?: string;
  row: AnswerShapeSortRow;
};

const none = { query: [] as string[], body: [] as string[] };

const CASES: Case[] = [
  // --- vet402_input（42）本文が missing/required/invalid/validation、または空で必須を送っていない ---
  {
    n: 1,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"missing_agentId"}',
      requestQuery: null,
      requestBody: "none",
      declaredInput: null,
      required: { query: ["agentId"], body: [] },
    },
  },
  {
    n: 1,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"missing \'symbol\', e.g. ?symbol=BTC&vs=USD"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: { query: ["symbol", "vs", "amount", "lang"], body: [] },
    },
  },
  {
    n: 3,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"missing or invalid \'amount\', e.g. ?amount=0.5"}',
      requestQuery: null,
      requestBody: "none",
      declaredInput: null,
      required: { query: ["amount"], body: [] },
    },
  },
  {
    n: 3,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。宣言どおり型 string に合う amount=100 を送っており、例は無い。本文の missing/invalid だけでは vet402 の誤りと示せないので unknown。seller_suspect にはしない。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"missing or invalid \'amount\' query param, e.g. ?amount=100"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["amount"], body: [] },
      fields: [{ name: "amount", in: "query", type: "string", example: null }],
      sentQuery: { amount: "100" },
    },
  },
  {
    n: 3,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。本文に validation があるが、必須項目が無く、送った値の型の落ち度も無い。語だけでは vet402_input にしないので unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"success":false,"error":"Validation errors","validationErrors":[{"field":"query","message":"empty_query_error"}]}',
      requestQuery: null,
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
    },
  },
  {
    n: 2,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。本文の required と、一社の書式で空だと書いてあることだけでは vet402 の誤りと示せない。その書式は見ない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"validationErrors":[{"field":"companyOrDomain","message":"field_required","actual":""}],"success":false}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
    },
  },
  {
    n: 2,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。url は型 string に合う値を送っている。一社の message の接頭辞や見本の URL では、売り手も vet402 も決めない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"validationErrors":[{"field":"url","message":"bad_profile_url","actual":"https://url/"}],"success":false}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: none,
      fields: [{ name: "url", in: "query", type: "string", example: null }],
      sentQuery: { url: "https://url/" },
    },
  },
  {
    n: 1,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。validation の語だけで、送った値が型の名前だと示す材料が行に無い。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"validationErrors":[{"type":"email","expected":"email","actual":"email","field":"email","message":"validation_email"}],"success":false}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
    },
  },
  {
    n: 1,
    human: "vet402_input",
    expect: "unknown",
    diverge:
      "人は vet402_input。validation の語だけで、送った中身の落ち度は示せない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"validationErrors":[{"expected":"non empty array","type":"arrayEmpty","actual":[],"field":"data"}],"success":false}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
    },
  },
  {
    n: 1,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "error_flag",
      bodyHead: '{"ok":false,"service":"abi","error":"query parameter `token` is required"}',
      requestQuery: null,
      requestBody: "none",
      declaredInput: null,
      required: { query: ["token"], body: [] },
    },
  },
  {
    n: 17,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "empty_structure",
      bodyHead: '{"data":[]}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: { query: ["id"], body: [] },
      outputType: "object",
    },
  },
  {
    n: 3,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "empty_structure",
      bodyHead: '{"data":{}}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: { query: ["username"], body: [] },
      outputType: "object",
    },
  },
  {
    n: 3,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "empty_structure",
      bodyHead: "{}",
      requestQuery: null,
      requestBody: "empty",
      declaredInput: null,
      required: none,
      bodyType: "string",
      outputType: "string",
    },
  },
  {
    n: 1,
    human: "vet402_input",
    expect: "vet402_input",
    row: {
      answerShape: "empty_structure",
      bodyHead: "[]",
      requestQuery: null,
      requestBody: "empty",
      declaredInput: null,
      required: none,
      bodyType: "string",
      outputType: "string",
    },
  },

  // --- valid_answer（17）空の結果、業務上の no、取得した頁・図 ---
  {
    n: 3,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "error_flag",
      bodyHead: '{"ok":false,"settled":true,"changed":false,"x":2500,"y":2100,"color":3}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["x", "y", "color"] },
      bodyType: "object",
      outputType: "object",
    },
  },
  {
    n: 3,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "html_page",
      bodyHead: '<!doctype html><html lang="en"><head><title>Example Domain</title></head><body>Example Domain</body></html>',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["url"] },
      outputType: "object",
    },
  },
  {
    n: 4,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "empty_structure",
      bodyHead: '{"items":[]}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["token_address", "page", "limit"], body: [] },
      outputType: "object",
    },
  },
  {
    n: 2,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "empty_structure",
      bodyHead: '{"result":[]}',
      requestQuery: "empty",
      requestBody: "none",
      declaredInput: null,
      required: none,
      outputType: "object",
    },
  },
  {
    n: 1,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "empty_structure",
      bodyHead: '{"results":[]}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["memory_key", "query", "filters"] },
      outputType: "object",
    },
  },
  {
    n: 1,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "empty_structure",
      bodyHead: "[]",
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
      outputType: null,
    },
  },
  {
    n: 1,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "empty_structure",
      bodyHead: "[]",
      requestQuery: null,
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
      outputType: null,
    },
  },
  {
    n: 1,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "html_page",
      bodyHead: '<!doctype html><html lang="en"><head><title>From a request to a finished artifact</title></head><body></body></html>',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["title", "nodes"] },
      outputType: null,
    },
  },
  {
    n: 1,
    human: "valid_answer",
    expect: "valid_answer",
    row: {
      answerShape: "error_flag",
      bodyHead: '{"requestedUrl":"https://example.com/article","finalUrl":"https://example.com/article","status":404,"ok":false,"contentType":"text/html"}',
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["url"] },
      outputType: "object",
    },
  },

  // --- seller_suspect（4）人は売り手の障害。requestQuery が null で宣言にクエリが無いとは分かっていないので unknown ---
  {
    n: 1,
    human: "seller_suspect",
    expect: "unknown",
    diverge:
      "人は seller_suspect。requestQuery が null（許可リスト外か Tempo でクエリを送っていない）で、declaredInput.query が empty ではない。宣言にクエリが無いとは分かっていないので、売り手の落ち度とは示せない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"success":false,"error":"a dependency is not installed"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "unknown",
    diverge:
      "人は seller_suspect。requestQuery が null で、宣言にクエリが無いとは分かっていない。売り手の落ち度とは示せない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"this route is retired","message":"use the replacement route"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "unknown",
    diverge:
      "人は seller_suspect。requestQuery が null で、宣言にクエリが無いとは分かっていない。売り手の落ち度とは示せない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"the upstream refused","success":false}',
      requestQuery: null,
      requestBody: "none",
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "unknown",
    diverge:
      "人は seller_suspect。requestQuery が null で、宣言にクエリが無いとは分かっていない。本文を送っていても、クエリを送っていない記録のまま売り手にはしない。unknown。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"a setting on this service is empty","status":"error"}',
      requestQuery: null,
      requestBody: "declared",
      declaredInput: null,
      required: none,
      bodyType: "object",
    },
  },

  // --- unknown（5）サイト枠、または登録手順が宣言に無く判断できない ---
  {
    n: 2,
    human: "unknown",
    expect: "unknown",
    row: {
      answerShape: "html_page",
      bodyHead: '<!DOCTYPE html><html lang="en" class="__variable_0a80b4"><head><link rel="stylesheet" href="/_next/static/css/x"/></head></html>',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: { query: [], body: [] },
    },
  },
  {
    n: 2,
    human: "unknown",
    expect: "unknown",
    row: {
      answerShape: "html_page",
      bodyHead: '<!DOCTYPE html><!--token--><html lang="en"><head><link rel="preload" href="/_next/static/media/a"/></head></html>',
      requestQuery: "empty",
      requestBody: "none",
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "unknown",
    expect: "unknown",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"the caller is not on the list — complete the setup step first"}',
      requestQuery: null,
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["tenant_id", "agent_id", "chain_id"] },
      bodyType: "object",
    },
  },
];

test("68件は人の仕分けと 52 件一致し、unknown に移った 16 件は理由を残す", () => {
  let total = 0;
  let matched = 0;
  const byHuman = { vet402_input: 0, valid_answer: 0, seller_suspect: 0, unknown: 0 };
  const gotCount = { vet402_input: 0, valid_answer: 0, seller_suspect: 0, unknown: 0 };
  for (const c of CASES) {
    total += c.n;
    byHuman[c.human] += c.n;
    const got = sortAnswerShape(c.row);
    gotCount[got] += c.n;
    assert.equal(got, c.expect, c.diverge ?? c.row.bodyHead.slice(0, 80));
    if (got === c.human) matched += c.n;
    else assert.ok(c.diverge, "人と違う行には diverge を書く");
    // 人の vet402 か valid の行は seller_suspect に混ぜない。
    if (c.human === "vet402_input" || c.human === "valid_answer") {
      assert.notEqual(got, "seller_suspect", c.row.bodyHead.slice(0, 80));
    }
  }
  assert.equal(total, 68);
  assert.deepEqual(byHuman, { vet402_input: 42, valid_answer: 17, seller_suspect: 4, unknown: 5 });
  // 段S1b の unknown 12（人の vet402 42 のうち 3+3+2+2+1+1）に、段S1c で人の seller 4 が unknown に移った。
  // 登録を先に求める 1 件は人と unknown で一致する。seller_suspect は 0（クエリを送ったと示せない）。
  assert.equal(matched, 52);
  assert.equal(gotCount.seller_suspect, 0);
  assert.equal(gotCount.vet402_input, 30);
  assert.equal(gotCount.valid_answer, 17);
  assert.equal(gotCount.unknown, 21);
});

test("各分類から 3 件以上、本文の頭が人の仕分けと一致する", () => {
  for (const label of ["vet402_input", "valid_answer", "seller_suspect", "unknown"] as const) {
    const rows = CASES.filter((c) => c.human === label);
    assert.ok(rows.length >= 3, label);
    for (const c of rows.slice(0, 3)) {
      assert.equal(sortAnswerShape(c.row), c.expect);
      assert.ok(c.row.bodyHead.length > 0);
    }
  }
});

test("型に合わない値と、例と同じ値は vet402_input。例と同じことを売り手の根拠にしない", () => {
  const base: AnswerShapeSortRow = {
    answerShape: "error_object",
    bodyHead: '{"error":"missing \'amount\'"}',
    requestQuery: "declared",
    requestBody: "none",
    declaredInput: null,
    required: { query: ["amount"], body: [] },
    fields: [{ name: "amount", in: "query", type: "number", example: 100 }],
  };
  assert.equal(sortAnswerShape({ ...base, sentQuery: { amount: "abc" } }), "vet402_input");
  // 例と同じ値。本文は missing。売り手の落ち度にはしない。
  assert.equal(sortAnswerShape({ ...base, sentQuery: { amount: "100" } }), "vet402_input");
  assert.equal(sortAnswerShape({ ...base, sentQuery: { amount: "string" } }), "vet402_input");
  // 宣言のクエリを送っていない。
  assert.equal(sortAnswerShape({ ...base, requestQuery: null, sentQuery: null }), "vet402_input");
  // 型に合う別の値。本文の missing だけでは vet402 の誤りと示せない。
  assert.equal(sortAnswerShape({ ...base, sentQuery: { amount: "50" } }), "unknown");
});

test("declared_input がクエリを宣言しているのに送っていない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "empty_structure",
      bodyHead: '{"data":[]}',
      requestQuery: "empty",
      requestBody: "none",
      declaredInput: { query: "declared", body: "empty" },
      required: none,
      outputType: "object",
    }),
    "vet402_input",
  );
});

test("ランナーと同じ入口: schema の必須クエリを送っていなければ vet402_input", () => {
  const got = sortAnswerShapeFromRun({
    answerShape: "error_object",
    bodyHead: '{"error":"missing \'symbol\', e.g. ?symbol=BTC&vs=USD"}',
    requestQuery: null,
    requestBody: "none",
    declaredSchema: {
      properties: {
        input: {
          properties: {
            queryParams: {
              type: "object",
              required: ["symbol"],
              properties: { symbol: { type: "string" } },
            },
          },
        },
        output: { properties: { example: { type: "object" } } },
      },
    },
    sentQuery: null,
    sentBody: null,
  });
  assert.equal(got, "vet402_input");
});

test("refused は、それだけで vet402_input", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"a dependency is not installed"}',
      requestQuery: "refused",
      requestBody: "none",
      declaredInput: null,
      required: none,
    }),
    "vet402_input",
  );
});

test("型の名前・example を送ったときは vet402_input。0 と任意の空文字は見本にしない", () => {
  const base: AnswerShapeSortRow = {
    answerShape: "error_object",
    bodyHead: '{"error":"a dependency is not installed"}',
    requestQuery: "declared",
    requestBody: "none",
    declaredInput: null,
    required: none,
    fields: [{ name: "q", in: "query", type: "string", example: null }],
  };
  for (const value of ["string", "number", "integer", "boolean", "example", "placeholder"]) {
    assert.equal(sortAnswerShape({ ...base, sentQuery: { q: value } }), "vet402_input", value);
  }
});

test("schema の fields にある項目を本文が欠けていると言い、送っていなければ vet402_input", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"missing \'symbol\'"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: none,
      fields: [{ name: "symbol", in: "query", type: "string", example: null }],
      sentQuery: { vs: "USD" },
    }),
    "vet402_input",
  );
});

test("script src があり本文の文字がほぼ無い HTML は unknown。枠組みのパスは見ない", () => {
  const vite = '<!doctype html><html><head><script type="module" src="/src/main.ts"></script></head><body><div id="app"></div></body></html>';
  assert.equal(
    sortAnswerShape({
      answerShape: "html_page",
      bodyHead: vite,
      requestQuery: "declared",
      requestBody: "declared",
      declaredInput: null,
      required: none,
    }),
    "unknown",
  );
  const titled = '<!doctype html><html><head><title>502 Bad Gateway</title></head><body><p>502 Bad Gateway</p></body></html>';
  assert.equal(
    sortAnswerShape({
      answerShape: "html_page",
      bodyHead: titled,
      requestQuery: "empty",
      requestBody: "declared",
      declaredInput: null,
      required: none,
    }),
    "unknown",
  );
});

test("success:false に障害の語があるときは valid_answer にしない", () => {
  const base: AnswerShapeSortRow = {
    answerShape: "error_flag",
    bodyHead: "",
    requestQuery: "declared",
    requestBody: "none",
    declaredInput: null,
    required: none,
    fields: [{ name: "q", in: "query", type: "string", example: null }],
    sentQuery: { q: "eth" },
  };
  for (const bodyHead of [
    '{"success":false,"error":"Internal server error"}',
    '{"success":false,"detail":"502"}',
    '{"success":false,"detail":"503"}',
    '{"success":false,"detail":"timeout"}',
  ]) {
    assert.equal(sortAnswerShape({ ...base, bodyHead }), "unknown", bodyHead);
  }
});

test("仕分けが throw しても unknown で、例外は出ない", () => {
  assert.equal(
    sortAnswerShapeCaught(() => {
      throw new Error("sort failed");
    }),
    "unknown",
  );
  const boom = new Proxy({} as Record<string, string>, {
    ownKeys() {
      throw new Error("boom");
    },
  });
  assert.equal(
    sortAnswerShapeCaught(() =>
      sortAnswerShape({
        answerShape: "error_object",
        bodyHead: '{"error":"a dependency is not installed"}',
        requestQuery: "declared",
        requestBody: "none",
        declaredInput: null,
        required: none,
        sentQuery: boom,
      }),
    ),
    "unknown",
  );
  assert.equal(sortAnswerShapeCaught(() => "seller_suspect"), "seller_suspect");
});

test("見本でない値を宣言どおり送り、入力の落ち度を名指さない error だけが seller_suspect", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"a dependency is not installed"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: none,
      fields: [{ name: "symbol", in: "query", type: "string", example: "BTC" }],
      sentQuery: { symbol: "ETH" },
    }),
    "seller_suspect",
  );
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"missing \'symbol\'"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: none,
      fields: [{ name: "symbol", in: "query", type: "string", example: null }],
      sentQuery: { symbol: "ETH" },
    }),
    "unknown",
  );
});

test("答えの形をしている本文は仕分けない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: null,
      bodyHead: '{"error":"missing \'symbol\'"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: { query: ["symbol"], body: [] },
    }),
    "unknown",
  );
});

const sellerBody = '{"error":"a dependency is not installed"}';

test("T1: schema 無し・requestQuery null の Please provide a symbol は seller_suspect にしない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"Please provide a symbol, e.g. ?symbol=BTC"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    }),
    "unknown",
  );
});

test("T4: q must be provided は seller_suspect にしない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"ok":false,"error":"q must be provided"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    }),
    "unknown",
  );
});

test("T2: queryParams の properties が空で symbol not supported は seller_suspect にしない", () => {
  const got = sortAnswerShapeFromRun({
    answerShape: "error_object",
    bodyHead: '{"error":"symbol not supported"}',
    requestQuery: null,
    requestBody: "none",
    declaredSchema: {
      properties: {
        input: {
          properties: {
            queryParams: { type: "object", properties: {} },
          },
        },
      },
    },
    declaredInput: null,
  });
  assert.equal(got, "unknown");
});

test("requestQuery が null でも、宣言にクエリが無いと分かっていれば seller_suspect にできる", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: null,
      requestBody: "none",
      declaredInput: { query: "empty", body: "empty" },
      required: none,
    }),
    "seller_suspect",
  );
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: null,
      requestBody: "none",
      declaredInput: { query: "declared", body: "empty" },
      required: none,
    }),
    "unknown",
  );
});

test("P1: page=0 は見本ではない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: none,
      fields: [{ name: "page", in: "query", type: "integer", example: null }],
      sentQuery: { page: "0" },
    }),
    "seller_suspect",
  );
});

test("P2: offset=0 は見本ではない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: "declared",
      requestBody: "declared",
      declaredInput: null,
      required: none,
      fields: [{ name: "offset", in: "body", type: "integer", example: null }],
      sentBody: { offset: 0 },
    }),
    "seller_suspect",
  );
});

test("P3: 任意項目の空文字は見本ではない", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["symbol"], body: [] },
      fields: [
        { name: "symbol", in: "query", type: "string", example: null },
        { name: "note", in: "query", type: "string", example: null },
      ],
      sentQuery: { symbol: "ETH", note: "" },
    }),
    "seller_suspect",
  );
});

test("P4: 必須項目の空文字は見本のまま vet402_input", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: sellerBody,
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["symbol"], body: [] },
      fields: [{ name: "symbol", in: "query", type: "string", example: null }],
      sentQuery: { symbol: "" },
    }),
    "vet402_input",
  );
});

test("P7: 宣言の例そのものを送って本文が invalid なら unknown", () => {
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"invalid symbol"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["symbol"], body: [] },
      fields: [{ name: "symbol", in: "query", type: "string", example: "BTC" }],
      sentQuery: { symbol: "BTC" },
    }),
    "unknown",
  );
  // missing のときは、例を送った側の落ち度のまま。
  assert.equal(
    sortAnswerShape({
      answerShape: "error_object",
      bodyHead: '{"error":"missing \'symbol\'"}',
      requestQuery: "declared",
      requestBody: "none",
      declaredInput: null,
      required: { query: ["symbol"], body: [] },
      fields: [{ name: "symbol", in: "query", type: "string", example: "BTC" }],
      sentQuery: { symbol: "BTC" },
    }),
    "vet402_input",
  );
});

test("2文字以下の項目名は、引用などで単独の語のときだけ当たる", () => {
  const idField = [{ name: "id", in: "query" as const, type: "string", example: null }];
  const base: AnswerShapeSortRow = {
    answerShape: "error_object",
    bodyHead: "",
    requestQuery: "declared",
    requestBody: "none",
    declaredInput: null,
    required: none,
    fields: idField,
    sentQuery: { vs: "USD" },
  };
  assert.equal(
    sortAnswerShape({ ...base, bodyHead: '{"error":"upstream request id missing"}' }),
    "unknown",
  );
  assert.equal(sortAnswerShape({ ...base, bodyHead: '{"error":"missing \'id\'"}' }), "vet402_input");
  assert.equal(sortAnswerShape({ ...base, bodyHead: '{"error":"missing_id"}' }), "vet402_input");
});
