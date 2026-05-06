import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

const router = Router();

interface AiInvocationRow {
  id: string;
  media_id: string | null;
  segment_id: string | null;
  provider: string | null;
  model_name: string | null;
  task_type: string | null;
  request_payload: string | null;
  response_payload: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost: number | null;
  status: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// GET /api/ai-invocations/summary — Aggregated statistics
// IMPORTANT: This route MUST be defined BEFORE /:id to avoid "summary" being captured as an :id param
router.get('/summary', (_req: Request, res: Response) => {
  const db = getDb();

  const totals = db.prepare(
    `SELECT
       COUNT(*) as total_invocations,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
     FROM ai_invocations`
  ).get() as {
    total_invocations: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_estimated_cost: number;
  };

  const byTaskTypeRows = db.prepare(
    `SELECT
       task_type,
       COUNT(*) as count,
       COALESCE(SUM(estimated_cost), 0) as cost
     FROM ai_invocations
     WHERE task_type IS NOT NULL
     GROUP BY task_type`
  ).all() as Array<{ task_type: string; count: number; cost: number }>;

  const by_task_type: Record<string, { count: number; cost: number }> = {};
  for (const row of byTaskTypeRows) {
    by_task_type[row.task_type] = { count: row.count, cost: row.cost };
  }

  return res.json({
    total_invocations: totals.total_invocations,
    total_input_tokens: totals.total_input_tokens,
    total_output_tokens: totals.total_output_tokens,
    total_estimated_cost: totals.total_estimated_cost,
    by_task_type,
  });
});

// POST /api/ai-invocations — Create a new invocation record
router.post('/', (req: Request, res: Response) => {
  const {
    media_id,
    segment_id,
    provider,
    model_name,
    task_type,
    request_payload,
    response_payload,
    input_tokens,
    output_tokens,
    estimated_cost,
    status,
    error_message,
    started_at,
    finished_at,
  } = req.body;

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO ai_invocations (id, media_id, segment_id, provider, model_name, task_type, request_payload, response_payload, input_tokens, output_tokens, estimated_cost, status, error_message, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    media_id ?? null,
    segment_id ?? null,
    provider ?? null,
    model_name ?? null,
    task_type ?? null,
    request_payload ?? null,
    response_payload ?? null,
    input_tokens ?? null,
    output_tokens ?? null,
    estimated_cost ?? null,
    status ?? null,
    error_message ?? null,
    started_at ?? null,
    finished_at ?? null,
    now,
  );

  const row = db.prepare('SELECT * FROM ai_invocations WHERE id = ?').get(id) as AiInvocationRow;
  return res.status(201).json(row);
});

// GET /api/ai-invocations — Query with optional filters and pagination
router.get('/', (req: Request, res: Response) => {
  const { media_id, task_type, status, page, pageSize } = req.query;

  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (media_id) {
    conditions.push('media_id = ?');
    params.push(media_id);
  }
  if (task_type) {
    conditions.push('task_type = ?');
    params.push(task_type);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const currentPage = Math.max(1, parseInt(page as string, 10) || 1);
  const currentPageSize = Math.max(1, parseInt(pageSize as string, 10) || 20);
  const offset = (currentPage - 1) * currentPageSize;

  const totalRow = db.prepare(
    `SELECT COUNT(*) as total FROM ai_invocations ${whereClause}`
  ).get(...params) as { total: number };

  const items = db.prepare(
    `SELECT * FROM ai_invocations ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, currentPageSize, offset) as AiInvocationRow[];

  return res.json({
    items,
    total: totalRow.total,
    page: currentPage,
    pageSize: currentPageSize,
  });
});

// PUT /api/ai-invocations/:id — Update status and response data
router.put('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM ai_invocations WHERE id = ?').get(id) as AiInvocationRow | undefined;
  if (!existing) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'AI 调用记录不存在' },
    });
  }

  const {
    status,
    response_payload,
    output_tokens,
    estimated_cost,
    error_message,
    finished_at,
  } = req.body;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (status !== undefined) {
    fields.push('status = ?');
    values.push(status);
  }
  if (response_payload !== undefined) {
    fields.push('response_payload = ?');
    values.push(response_payload);
  }
  if (output_tokens !== undefined) {
    fields.push('output_tokens = ?');
    values.push(output_tokens);
  }
  if (estimated_cost !== undefined) {
    fields.push('estimated_cost = ?');
    values.push(estimated_cost);
  }
  if (error_message !== undefined) {
    fields.push('error_message = ?');
    values.push(error_message);
  }
  if (finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(finished_at);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE ai_invocations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM ai_invocations WHERE id = ?').get(id) as AiInvocationRow;
  return res.json(updated);
});

export default router;
