import { z } from 'zod';

/** Local transport metadata boundary (ADR 634); not a wire message or an authorization. */
export const ClientAddressSchema = z
  .string()
  .ip()
  .refine((address) => !address.includes('%'), 'scope identifiers are not client addresses');
