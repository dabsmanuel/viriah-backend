import type { Express, Router } from 'express';
import { API_PREFIX } from '../core/route';
import { router as auth } from './auth';
import { router as system, localFileRoutes } from './system';
import { router as platform } from './platform';
import { router as publicPlatform } from './publicPlatform';
import { router as school } from './school';
import { router as academics } from './academics';
import { router as students } from './students';
import { router as staff } from './staff';
import { router as fees } from './fees';
import { router as payments } from './payments';
import { router as comms } from './comms';
import { router as admissions } from './admissions';
import { router as website } from './website';
import { router as attendance } from './attendance';
import { router as tasks } from './tasks';
import { router as results } from './results';
import { router as promotion } from './promotion';
import { router as imports } from './imports';
import { router as portal } from './portal';

/** Every module's routes, in one place. The route table that the tenancy test walks is built from these. */
const routers: Router[] = [auth, system, platform, publicPlatform, school, academics, students, staff, fees, payments, comms, admissions, website, attendance, tasks, results, promotion, imports, portal];

export function registerAllModules(app: Express) {
  app.use(API_PREFIX, localFileRoutes);
  for (const r of routers) app.use(API_PREFIX, r);
}
