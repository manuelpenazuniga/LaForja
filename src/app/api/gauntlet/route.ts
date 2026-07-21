/** Next.js route boundary for the streaming gauntlet endpoint. */
import { handleGauntlet } from './logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleGauntlet(req);
}
