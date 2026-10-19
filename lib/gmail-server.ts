import { env } from "cloudflare:workers";
import {
  authorizeGmailRequest,
  createGmailService,
  GmailError,
  type GmailEnvironment,
  type ReviewEmail,
} from "./gmail.ts";

function service() {
  const bindings = env as unknown as GmailEnvironment & { DB?: D1Database };
  return createGmailService({ env: bindings, db: bindings.DB });
}
export function gmailStatus(request: Request) {
  return service().status(request);
}
export function gmailAuthorize(request: Request) {
  return authorizeGmailRequest(request, env as GmailEnvironment);
}
export function gmailAction(request: Request, input: Record<string, unknown>) {
  return service().action(request, input);
}
export function gmailCallback(request: Request) {
  return service().callback(request);
}
export function sendReviewEmail(request: Request, mail: ReviewEmail) {
  return service().send(request, mail);
}
export function readReviewEmailDelivery(id: string) {
  return service().readDelivery(id);
}
export function gmailErrorResponse(error: unknown) {
  return Response.json(
    {
      error: error instanceof GmailError ? error.code : "MAIL_SERVICE",
      message:
        error instanceof GmailError
          ? error.message
          : "邮箱连接服务暂时不可用，请稍后重试。",
    },
    {
      status: error instanceof GmailError ? error.status : 503,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
