import { z } from 'zod';

/** Local transport metadata boundary (ADR 634); not a wire message or an authorization. */
export const ClientAddressSchema = z
  .union([z.ipv4(), z.ipv6()])
  .refine((address) => !address.includes('%'), 'scope identifiers are not client addresses');
