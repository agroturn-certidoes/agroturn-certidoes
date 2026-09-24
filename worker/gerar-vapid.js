// Gera o par de chaves que identifica a Agroturn perante os serviços de aviso (Chrome, Safari, Firefox).
// Rode UMA vez:   node gerar-vapid.js
//   - CHAVE PÚBLICA  -> vai no config.js do site (vapidPublicKey). Pode ser pública.
//   - CHAVE PRIVADA  -> só no Cloudflare:  wrangler secret put VAPID_PRIVATE_JWK   (nunca no repositório).
const { generateKeyPairSync } = require("crypto");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const b64url = (b) => Buffer.from(b).toString("base64url");
const publica = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));

console.log("\n=== CHAVE PÚBLICA (vai no config.js -> vapidPublicKey; pode me mandar) ===\n");
console.log(publica);
console.log("\n=== CHAVE PRIVADA (cole no: wrangler secret put VAPID_PRIVATE_JWK — NÃO compartilhe) ===\n");
console.log(JSON.stringify(jwk));
console.log("");
