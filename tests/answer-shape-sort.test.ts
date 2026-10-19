import { test } from "node:test";
import assert from "node:assert/strict";
import { sortAnswerShape, sortAnswerShapeFromRun, type AnswerShapeSort, type AnswerShapeSortRow } from "../src/lib/observatory/answer-shape-sort";

// 2026-09-15〜10-15 の 68 件（人が 2026-10-18 に仕分けたもの）。本文の頭と、クエリ・本文を送ったかだけ。
// 売り手の名前は書かない。件数 n は同じ形の行数。human が関数と違う行だけ diverge に理由を書く。

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
    expect: "vet402_input",
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
    expect: "vet402_input",
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
    expect: "vet402_input",
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
    expect: "vet402_input",
    row: {
      answerShape: "error_object",
      bodyHead: '{"validationErrors":[{"field":"url","message":"wrong_linkedin_url","actual":"https://url/"}],"success":false}',
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
    expect: "vet402_input",
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
    expect: "vet402_input",
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

  // --- seller_suspect（4）宣言どおり（または送るものが無い）なのに、売り手の障害 ---
  {
    n: 1,
    human: "seller_suspect",
    expect: "seller_suspect",
    row: {
      answerShape: "error_object",
      bodyHead: '{"success":false,"error":"Cannot find package \'node-fetch\'"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "seller_suspect",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"endpoint deprecated","message":"Use GET /satellites/precision instead"}',
      requestQuery: null,
      requestBody: null,
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "seller_suspect",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"Reddit: 403","success":false}',
      requestQuery: null,
      requestBody: "none",
      declaredInput: null,
      required: none,
    },
  },
  {
    n: 1,
    human: "seller_suspect",
    expect: "seller_suspect",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"No outbound number configured","status":"error"}',
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
    expect: "seller_suspect",
    diverge:
      "人は unknown。宣言に無い登録（POST /register）を先に求めていて、どちらの落ち度か本文からは決まらない。関数は、宣言した本文を送ったあとの error_object で missing/required/invalid/validation が無いので seller_suspect。登録が宣言に無いことは入力に無いので、合わせない。",
    row: {
      answerShape: "error_object",
      bodyHead: '{"error":"tenant_id is not registered — call POST /register first to claim your namespace and receive your owner_token"}',
      requestQuery: null,
      requestBody: "declared",
      declaredInput: null,
      required: { query: [], body: ["tenant_id", "agent_id", "chain_id"] },
      bodyType: "object",
    },
  },
];

test("68件は人の仕分けと 67 件一致し、ずれる 1 件は理由を残す", () => {
  let total = 0;
  let matched = 0;
  const byHuman = { vet402_input: 0, valid_answer: 0, seller_suspect: 0, unknown: 0 };
  for (const c of CASES) {
    total += c.n;
    byHuman[c.human] += c.n;
    const got = sortAnswerShape(c.row);
    assert.equal(got, c.expect, c.diverge ?? c.row.bodyHead.slice(0, 80));
    if (got === c.human) matched += c.n;
    else assert.ok(c.diverge, "人と違う行には diverge を書く");
  }
  assert.equal(total, 68);
  assert.deepEqual(byHuman, { vet402_input: 42, valid_answer: 17, seller_suspect: 4, unknown: 5 });
  assert.equal(matched, 67);
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

test("送った値が宣言の型・例と違うときだけ vet402_input（語だけでは決めない）", () => {
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
  // 例と同じ値を送っている。本文は missing だが invalid/validation ではないので、売り手側に残す。
  assert.equal(sortAnswerShape({ ...base, sentQuery: { amount: "100" } }), "seller_suspect");
  // 宣言のクエリを送っていない。
  assert.equal(sortAnswerShape({ ...base, requestQuery: null, sentQuery: null }), "vet402_input");
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
