import { candidateReviewAction, candidateReviewSnapshot, errorResponse, readBody } from "../../../lib/server";

export async function GET(request: Request) {
  try { return await candidateReviewSnapshot(request); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { return await candidateReviewAction(request, await readBody(request)); }
  catch (error) { return errorResponse(error); }
}
