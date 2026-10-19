import { careersAction, careersSnapshot, errorResponse, readBody } from "../../../lib/server";

export async function GET() {
  try { return await careersSnapshot(); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { return await careersAction(request, await readBody(request)); }
  catch (error) { return errorResponse(error); }
}
