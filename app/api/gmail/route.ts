import {
  gmailAction,
  gmailAuthorize,
  gmailErrorResponse,
  gmailStatus,
} from "../../../lib/gmail-server";
import { readGmailRequest } from "../../../lib/gmail-request";

export async function GET(request: Request) {
  try {
    return Response.json(await gmailStatus(request), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return gmailErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    gmailAuthorize(request);
    return await gmailAction(request, await readGmailRequest(request));
  } catch (error) {
    return gmailErrorResponse(error);
  }
}
