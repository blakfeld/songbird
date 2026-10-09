export const NAME_MAX = 40;
export const BODY_MAX = 2000;
export const BODY_MAX_LINES = 30;

// Counted in code points because that is what the server counts, and an emoji must not cost two.
export const commentLength = (text: string) => [...text].length;

// Control characters other than the line feed, and the bidirectional overrides and isolates that let text lie about its direction.
const FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/u;

export const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ");

export const normalizeBody = (body: string) => body.trim();

export interface CommentCheck {
  name?: string;
  body?: string;
}

// The server stays the authority; these checks only spare a round trip for what it would refuse anyway.
export function checkComment(rawName: string, rawBody: string): CommentCheck {
  const name = normalizeName(rawName);
  const body = normalizeBody(rawBody);
  const problems: CommentCheck = {};
  if (name.length === 0) problems.name = "Enter your name.";
  else if (commentLength(name) > NAME_MAX) problems.name = `Your name can be at most ${NAME_MAX} characters.`;
  else if (FORBIDDEN.test(name)) problems.name = "Your name has characters that aren't allowed.";

  if (body.length === 0) problems.body = "Write a comment.";
  else if (commentLength(body) > BODY_MAX) problems.body = `A comment can be at most ${BODY_MAX} characters.`;
  else if (body.split("\n").length > BODY_MAX_LINES) problems.body = `A comment can be at most ${BODY_MAX_LINES} lines.`;
  else if (FORBIDDEN.test(body)) problems.body = "Your comment has characters that aren't allowed.";
  return problems;
}
