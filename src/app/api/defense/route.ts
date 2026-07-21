/** Next.js route boundary for the two-phase written defense endpoint. */
import { handleDefense } from './logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleDefense(req);
}
