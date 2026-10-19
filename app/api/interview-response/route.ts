import { interviewResponseAction, interviewResponseSnapshot, errorResponse, readBody } from "../../../lib/server";

export async function GET(request: Request) {
  try { return await interviewResponseSnapshot(request); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { return await interviewResponseAction(request, await readBody(request)); }
  catch (error) { return errorResponse(error); }
}
