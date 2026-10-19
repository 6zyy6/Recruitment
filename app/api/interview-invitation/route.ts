import { interviewInvitationAction, errorResponse, readBody } from "../../../lib/server";

export async function POST(request: Request) {
  try { return await interviewInvitationAction(request, await readBody(request)); }
  catch (error) { return errorResponse(error); }
}
