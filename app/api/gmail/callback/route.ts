import {
  gmailCallback,
  gmailErrorResponse,
} from "../../../../lib/gmail-server";

export async function GET(request: Request) {
  try {
    return await gmailCallback(request);
  } catch (error) {
    return gmailErrorResponse(error);
  }
}
