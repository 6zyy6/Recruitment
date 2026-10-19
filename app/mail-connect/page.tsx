import type { Metadata } from "next";
import MailConnect from "@/components/recruitment/MailConnect";

export const metadata: Metadata = {
  title: "连接招聘发件邮箱 · 拾才",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MailConnectPage() {
  return <MailConnect />;
}
