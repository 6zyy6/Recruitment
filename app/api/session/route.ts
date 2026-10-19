import {
  errorResponse,
  getUser,
  login,
  logout,
  readBody,
} from "../../../lib/server";
import { DEMO_USERS } from "../../../lib/seed";

export async function GET(request: Request) {
  try {
    return Response.json(
      { user: await getUser(request), users: DEMO_USERS },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return await login(request, await readBody(request));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request) {
  try {
    return await logout(request);
  } catch (error) {
    return errorResponse(error);
  }
}
