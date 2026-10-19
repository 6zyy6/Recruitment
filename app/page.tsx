import Workspace from "@/components/recruitment/Workspace";
import { env } from "cloudflare:workers";
import { requireChatGPTUser, chatGPTSignOutPath } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = env as unknown as {
    MAIL_MODE?: string;
    MAIL_OPERATOR_EMAIL?: string;
  };
  if (config.MAIL_MODE === "live") {
    const user = await requireChatGPTUser("/");
    if (
      !config.MAIL_OPERATOR_EMAIL ||
      user.email.toLowerCase() !==
        config.MAIL_OPERATOR_EMAIL.trim().toLowerCase()
    )
      return (
        <main className="startup">
          <h1>招聘管理后台</h1>
          <p>当前账号没有管理权限。候选人请使用邮件中的专属核对链接。</p>
          <a href={chatGPTSignOutPath("/")} target="_top">
            切换登录账号
          </a>
        </main>
      );
  }
  return <Workspace />;
}
