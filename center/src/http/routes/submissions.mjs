// Center HTTP 路由：提交与评审（T7 归置）。

import { createReview, getSubmission, listReviews } from '../../db/submissions.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/submissions/:id',
    handler: ({ params, db }) => {
      const submission = getSubmission(db, params.id);
      if (!submission) {
        return { status: 404, body: { ok: false, error: `提交不存在：${params.id}` } };
      }
      return submission;
    },
  },
  {
    method: 'POST',
    pattern: '/submissions/:id/review',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createReview(db, { ...body, submission_id: params.id }),
    }),
  },
  {
    method: 'GET',
    pattern: '/submissions/:id/reviews',
    handler: ({ params, db }) => {
      if (!getSubmission(db, params.id)) {
        return { status: 404, body: { ok: false, error: `提交不存在：${params.id}` } };
      }
      return listReviews(db, params.id);
    },
  },
];
