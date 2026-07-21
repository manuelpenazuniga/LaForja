/** Next.js route boundary for version repair and history re-run. */
import { handleRepair } from './logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleRepair(req);
}
