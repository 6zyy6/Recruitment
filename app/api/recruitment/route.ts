import {
  errorResponse,
  readBody,
  recruitmentAction,
  recruitmentSnapshot,
} from "../../../lib/server";

export async function GET(request: Request) {
  try {
    return await recruitmentSnapshot(request);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return await recruitmentAction(request, await readBody(request));
  } catch (error) {
    return errorResponse(error);
  }
}
