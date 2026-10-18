// src/app.ts
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  createAccount,
  validateCreateAccountInput,
  validateUpdateAccountPlanInput,
  updateAccountPlan,
  AccountValidationError,
  AccountNotFoundError,
} from './accounts.js';
import { createAuthPreHandler } from './auth.js';
import {
  getAccessiblePlan,
  listAccessiblePlans,
  validatePlanTypeFilter,
  validatePlanDefinition,
  validatePlanUpdateInput,
  createCustomPlan,
  updateCustomPlan,
  assertResourceFound,
  NotFoundError,
  ForbiddenError,
  PlanValidationError,
} from './plans.js';
import {
  createUser,
  getUserById,
  updateUserPlan,
  validateCreateUserInput,
  validateUpdateUserPlanInput,
  UserValidationError,
  UserConflictError,
  UserNotFoundError,
} from './users.js';
import {
  getAccountCurrentUsage,
  getUserCurrentUsage,
  assertNoUnsupportedQueryParams,
  UsageQueryValidationError,
} from './usage.js';

export interface AppOptions {
  checkHealth: () => Promise<boolean>;
  pool?: pg.Pool;
}

/**
 * دالة بناء التطبيق (App Factory):
 * تنشئ نسخة Fastify وتضبط مسارات الخدمة بالكامل دون فتح أي منفذ شبكة.
 * تتطلب دالة checkHealth لفحص جاهزية الاعتماديات (قاعدة البيانات).
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  // 1. مسار فحص الحياة (Liveness): يفحص أن عملية Node.js تستجيب
  app.get('/health', async (_request, _reply) => {
    return { status: 'ok' };
  });

  // 2. مسار فحص الجاهزية (Readiness): يستدعي دالة الفحص الإلزامية
  app.get('/health/ready', async (_request, reply) => {
    const isHealthy = await options.checkHealth();

    if (isHealthy) {
      return reply.code(200).send({ ready: true, database: 'connected' });
    }

    return reply.code(503).send({ ready: false, database: 'disconnected' });
  });

  // 3. مسار تسجيل الحساب الجديد وإصدار مفتاح API لأول مرة: POST /accounts
  app.post('/accounts', async (request, reply) => {
    if (!options.pool) {
      return reply.code(500).send({ error: 'Database pool is not configured' });
    }

    try {
      const validatedInput = validateCreateAccountInput(request.body);
      const createdAccount = await createAccount(options.pool, validatedInput);
      return reply.code(201).send(createdAccount);
    } catch (err) {
      if (err instanceof AccountValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      console.error('Failed to create account due to an unexpected error');
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });

  // 4. مسار استرجاع بيانات الحساب الحالي الموثق بمفتاح API: GET /account/me
  const requireAuth = createAuthPreHandler(options.pool);

  app.get(
    '/account/me',
    { preHandler: requireAuth },
    async (request, reply) => {
      const account = request.account;
      if (!account) {
        return reply.code(500).send({ error: 'Account context missing' });
      }

      return reply.code(200).send(account);
    }
  );

  // 5. مسار تغيير خطة الحساب: PATCH /account/plan (Part 14)
  app.patch(
    '/account/plan',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;

      try {
        const validatedInput = validateUpdateAccountPlanInput(request.body);
        const updatedAccount = await updateAccountPlan(
          options.pool,
          accountId,
          validatedInput.planId
        );
        return reply.code(200).send(updatedAccount);
      } catch (err) {
        if (err instanceof AccountValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to update account plan due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 6. مسار استرجاع خطة متاحة للحساب الموثق: GET /plans/:planId
  app.get<{ Params: { planId: string } }>(
    '/plans/:planId',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const { planId } = request.params;
      const accountId = request.account!.id;

      try {
        const plan = await getAccessiblePlan(options.pool, planId, accountId);
        const accessiblePlan = assertResourceFound(plan, 'Plan not found');
        return reply.code(200).send(accessiblePlan);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to retrieve plan due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 6. مسار إنشاء مستخدم وإسناد خطة له: POST /users
  app.post(
    '/users',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;

      try {
        const validatedInput = validateCreateUserInput(request.body);
        const user = await createUser(options.pool, accountId, validatedInput);
        return reply.code(201).send(user);
      } catch (err) {
        if (err instanceof UserValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof UserConflictError) {
          return reply.code(409).send({ error: err.message });
        }
        console.error('Failed to create user due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 7. مسار استرجاع بيانات مستخدم: GET /users/:userId
  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;
      const { userId } = request.params;

      try {
        const user = await getUserById(options.pool, userId, accountId);
        if (!user) {
          return reply.code(404).send({ error: 'User not found' });
        }
        return reply.code(200).send(user);
      } catch (err) {
        console.error('Failed to retrieve user due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 8. مسار تغيير خطة مستخدم: PATCH /users/:userId/plan
  app.patch<{ Params: { userId: string } }>(
    '/users/:userId/plan',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;
      const { userId } = request.params;

      try {
        const validatedInput = validateUpdateUserPlanInput(request.body);
        const updatedUser = await updateUserPlan(
          options.pool,
          userId,
          accountId,
          validatedInput.planId
        );
        return reply.code(200).send(updatedUser);
      } catch (err) {
        if (err instanceof UserValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof UserNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to update user plan due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 9. مسار استرجاع قائمة الخطط المتاحة للحساب: GET /plans
  app.get<{ Querystring: { type?: unknown } }>(
    '/plans',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;

      try {
        const typeFilter = validatePlanTypeFilter(request.query.type);
        const plans = await listAccessiblePlans(options.pool, accountId, typeFilter);
        return reply.code(200).send(plans);
      } catch (err) {
        if (err instanceof PlanValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        console.error('Failed to list plans due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 10. مسار إنشاء خطة خاصة: POST /plans
  app.post(
    '/plans',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;

      try {
        const validatedInput = validatePlanDefinition(request.body);
        const plan = await createCustomPlan(options.pool, accountId, validatedInput);
        return reply
          .code(201)
          .header('Location', `/plans/${plan.id}`)
          .send(plan);
      } catch (err) {
        if (err instanceof PlanValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        console.error('Failed to create custom plan due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 11. مسار تعديل خطة خاصة: PATCH /plans/:planId
  app.patch<{ Params: { planId: string } }>(
    '/plans/:planId',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;
      const { planId } = request.params;

      try {
        const validatedInput = validatePlanUpdateInput(request.body);
        const updatedPlan = await updateCustomPlan(
          options.pool,
          planId,
          accountId,
          validatedInput
        );
        return reply.code(200).send(updatedPlan);
      } catch (err) {
        if (err instanceof PlanValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof ForbiddenError) {
          return reply.code(403).send({ error: err.message });
        }
        if (err instanceof NotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to update custom plan due to an unexpected error');
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 12. مسار استرجاع استخدام الحساب للشهر الحالي: GET /account/usage (Part 23)
  app.get(
    '/account/usage',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;

      try {
        assertNoUnsupportedQueryParams(request.query);
        const usage = await getAccountCurrentUsage(options.pool, accountId);
        return reply.code(200).send(usage);
      } catch (err) {
        if (err instanceof UsageQueryValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to get account usage due to an unexpected error:', err);
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // 13. مسار استرجاع استخدام المستخدم للشهر الحالي: GET /users/:userId/usage (Part 23)
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/usage',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!options.pool) {
        return reply.code(500).send({ error: 'Database pool is not configured' });
      }

      const accountId = request.account!.id;
      const { userId } = request.params;

      try {
        assertNoUnsupportedQueryParams(request.query);
        const usage = await getUserCurrentUsage(options.pool, accountId, userId);
        return reply.code(200).send(usage);
      } catch (err) {
        if (err instanceof UsageQueryValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof UserNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        console.error('Failed to get user usage due to an unexpected error:', err);
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  return app;
}


