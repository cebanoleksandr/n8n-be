import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export class PaginationQuery implements Pagination {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  limit: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}
