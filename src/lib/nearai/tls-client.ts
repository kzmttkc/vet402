import { createHash, X509Certificate } from "node:crypto";
import * as https from "node:https";
import type { TLSSocket } from "node:tls";

export type SameSocketResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  peerSpkiSha256: string | null;
  json: unknown | null;
  raw?: string;
};

export function fetchSameSocketReport(urlStr: string, extraHeaders: Record<string, string> = {}): Promise<SameSocketResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    let peerSpkiSha256: string | null = null;
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        agent,
        headers: {
          Accept: "application/json",
          "User-Agent": "vet402-observatory-nearai/1.0 (+https://vet402.com/observatory/nearai)",
          ...extraHeaders,
        },
        timeout: 45_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          agent.destroy();
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(body);
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            peerSpkiSha256,
            json,
            raw: json ? undefined : body.slice(0, 400),
          });
        });
      },
    );
    req.on("socket", (socket) => {
      socket.on("secureConnect", () => {
        const tls = socket as TLSSocket;
        const cert = tls.getPeerCertificate(false);
        if (cert?.raw) {
          const x509 = new X509Certificate(cert.raw);
          const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
          peerSpkiSha256 = createHash("sha256").update(spkiDer).digest("hex");
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", (err) => {
      agent.destroy();
      reject(err);
    });
    req.end();
  });
}