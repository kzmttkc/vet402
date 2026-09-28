// 公開 HTML 頁の読み取りキャッシュの窓（cached-reads.ts から移した・値と理由は変えていない）。
// 依存を持たない置き場所にしたのは、/sellers の頁が cached-reads.ts → reader.ts → l0-probe.ts（支払いの
// モジュールを import する）を辿らずに同じ値を使うため（tests/sellers-no-payment-imports.test.ts）。

/**
 * 秒。**1 つの値しか置かない。**
 *
 * 面ごとに 300 / 600 / 3600 と刻みたくなるが、それをやると
 * 「方法論頁の 5 つの内訳の合計は /api/v1/observatory/state の
 * publishedUnverified と一致する」という頁自身の主張が、cron 直後の
 * 最大 1 時間だけ崩れる。頁と API の食い違いを 5 分に閉じ、
 * その 5 分をここに書いておく方が、鮮度を刻んで得られる速度より価値がある。
 */
export const PUBLIC_READ_REVALIDATE = 300;
