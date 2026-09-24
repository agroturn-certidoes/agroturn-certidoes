// Gera o par de chaves que identifica a Agroturn perante os serviços de aviso (Chrome, Safari, Firefox).
// Rode UMA vez, dentro da pasta worker:   node gerar-vapid.js
//   - CHAVE PÚBLICA  -> aparece na tela; vai no config.js do site (vapidPublicKey). Pode ser pública.
//   - CHAVE PRIVADA  -> NÃO aparece na tela: é gravada no arquivo .vapid-privada.json (ignorado pelo git).
//     Cadastre no Cloudflare e apague o arquivo:
//        Get-Content .vapid-privada.json -Raw | wrangler secret put VAPID_PRIVATE_JWK
//        Remove-Item .vapid-privada.json
const { generateKeyPairSync } = require("crypto");
const fs = require("fs");
const path = require("path");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const b64url = (b) => Buffer.from(b).toString("base64url");
const publica = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));

const arquivo = path.join(__dirname, ".vapid-privada.json");
fs.writeFileSync(arquivo, JSON.stringify(jwk));

console.log("\n=== CHAVE PÚBLICA (vai no config.js -> vapidPublicKey; pode me mandar) ===\n");
console.log(publica);
console.log("\nA chave privada foi gravada em: " + arquivo);
console.log("Próximo passo (copie e cole no terminal):\n");
console.log("  Get-Content .vapid-privada.json -Raw | wrangler secret put VAPID_PRIVATE_JWK");
console.log("  Remove-Item .vapid-privada.json\n");
