import { randomBytes } from "node:crypto";

export function createLocalToken(): string {
  return `local_${randomBytes(24).toString("base64url")}`;
}

export function extractToken(input: {
  authorization?: string;
  queryToken?: string;
}): string | undefined {
  if (input.queryToken) {
    return input.queryToken;
  }

  const authorization = input.authorization;
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
