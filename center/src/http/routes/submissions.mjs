// Center HTTP 路由：提交与评审（T7 归置；P1 接入人类专属授权）。

import {
  createReview,
  getSubmission,
  listReviews,
  verifySubmissionCommits,
} from '../../db/submissions.mjs';
import { getTask } from '../../db/tasks.mjs';
import { assertCan, assertProjectRole, stampActorType } from '../../auth/policy.mjs';

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
    handler: ({ params, body, db, req }) => {
      const submission = getSubmission(db, params.id);
      if (!submission) {
        return { status: 404, body: { ok: false, error: `提交不存在：${params.id}` } };
      }
      const task = getTask(db, submission.task_id);
      const auth = assertCan(db, req, 'review.record', { project_id: task?.project_id });
      assertProjectRole(db, auth, 'review.record', { project_id: task?.project_id });
      const payload = { ...body, submission_id: params.id };
      if (!payload.reviewer_id && !payload.reviewerId && auth.actor) {
        payload.reviewer_id = auth.actor.display_name;
      }
      const review = createReview(db, payload);
      stampActorType(db, 'reviews', 'review_id', review.review_id, auth.actor_type);
      return { status: 201, body: { ...review, reviewer_actor_type: auth.actor_type } };
    },
  },
  {
    method: 'POST',
    pattern: '/submissions/:id/verify-commits',
    handler: ({ params, body, db }) => {
      if (!getSubmission(db, params.id)) {
        return { status: 404, body: { ok: false, error: `提交不存在：${params.id}` } };
      }
      return { status: 200, body: verifySubmissionCommits(db, params.id, body) };
    },
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
