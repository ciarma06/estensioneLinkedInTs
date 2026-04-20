function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export type JwtPayload = {
  email: string;
  access: string;
  exp: number;
};

export async function signJwt(
  payload: JwtPayload,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  try {
    const key = await importKey(secret);
    const signature = base64UrlDecode(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(signingInput),
    );
    if (!valid) return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as JwtPayload;

    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      return null;
    }

    if (typeof payload.email !== "string" || typeof payload.access !== "string") {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
