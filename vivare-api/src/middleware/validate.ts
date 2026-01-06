import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { Errors } from './error-handler.js';

export const validate = (schema: AnyZodObject) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const details = error.issues.map(err => ({
                    path: err.path.join('.'),
                    message: err.message
                }));
                next(Errors.badRequest('Validation failed', { details }));
            } else {
                next(error);
            }
        }
    };
