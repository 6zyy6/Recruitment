// Sites must authenticate these headers and strip client-supplied copies at its
// hosted ingress. This helper does not verify header provenance itself; ordinary
// local or directly forwarded headers are not a production identity mechanism.
const SIGN_IN_URL = "/signin-with-chatgpt?return_to=%2Fmail-connect";

export class OperatorError extends Error {
  code: string;
  status: number;
  signInUrl?: string;

  constructor(code: string, message: string, status: number, signInUrl?: string) {
    super(message);
    this.code = code;
    this.status = status;
    if (signInUrl) this.signInUrl = signInUrl;
  }
}

export function requireMailOperator(
  request: Request,
  config: { MAIL_OPERATOR_EMAIL?: string },
): { email: string; userId: string } {
  const allowedEmail = config.MAIL_OPERATOR_EMAIL?.trim().toLowerCase();
  if (!allowedEmail)
    throw new OperatorError(
      "MAIL_OPERATOR_NOT_CONFIGURED",
      "尚未配置允许操作邮件服务的账号",
      503,
    );

  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();
  if (!userId || !email)
    throw new OperatorError(
      "MAIL_SIGN_IN_REQUIRED",
      "请先通过 ChatGPT 登录允许使用的账号",
      401,
      SIGN_IN_URL,
    );
  if (email !== allowedEmail)
    throw new OperatorError(
      "MAIL_FORBIDDEN",
      "当前登录账号没有操作权限",
      403,
    );
  return { email, userId };
}

export function requireRecruitmentOperator(
  request: Request,
  config: { MAIL_MODE?: string; MAIL_OPERATOR_EMAIL?: string; DEEPSEEK_API_KEY?: string },
): { email: string; userId: string } | null {
  return config.MAIL_MODE === "live" || Boolean(config.DEEPSEEK_API_KEY?.trim())
    ? requireMailOperator(request, config)
    : null;
}
