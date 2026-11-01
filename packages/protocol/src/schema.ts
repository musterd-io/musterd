import { z } from 'zod';

/** ADR 784: an override records only chosen fields; defaults belong to the dense read schema. */
export function sparsePartial<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): ReturnType<z.ZodObject<T>['partial']> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      z.optional(
        field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field,
      ),
    ]),
  );
  // The optional output type is unchanged by removing defaults before making fields optional.
  return z.object(shape) as ReturnType<z.ZodObject<T>['partial']>;
}
