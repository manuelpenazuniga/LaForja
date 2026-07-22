/** Next.js route boundary for creating a visitor's own from-scratch item (doc §4). */
import { handleCreateItem } from './logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleCreateItem(req);
}
