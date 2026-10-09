import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ExpressionError } from '../../engine/errors.js';
import { resolveParameter } from '../../engine/expression.js';
import {
  type ExpressionReference,
  expressionReference,
} from '../../engine/expression/reference.js';
import type { BinaryRef, Item, JsonObject } from '../../engine/types.js';

const evaluateSchema = z.object({
  /** Parameter value as typed in the editor, e.g. "Hi {{ $json.name }}". */
  expression: z.string().max(10_000),
  json: z.record(z.string(), z.unknown()).default({}),
  binary: z.record(z.string(), z.unknown()).optional(),
  itemIndex: z.number().int().min(0).default(0),
  /** Outputs of earlier nodes by name (first output, JSON only). */
  nodes: z
    .record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .default({}),
});

class EvaluateExpressionDto {
  expression: string;
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  itemIndex: number;
  nodes: Record<string, Record<string, unknown>[]>;
}

@ApiTags('expressions')
@Controller('expressions')
export class ExpressionsController {
  @Get('reference')
  @ApiOkResponse({
    description: 'Variables, functions and methods for autocomplete',
  })
  reference(): ExpressionReference {
    return expressionReference();
  }

  /** Live preview in the editor: same evaluator the worker uses, on sample data. */
  @Post('evaluate')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          example: '{{ $json.name.toUpperCase() }}',
        },
        json: {
          type: 'object',
          additionalProperties: true,
          example: { name: 'Ann' },
        },
        binary: { type: 'object', additionalProperties: true },
        itemIndex: { type: 'integer', default: 0 },
        nodes: { type: 'object', additionalProperties: { type: 'array' } },
      },
    },
  })
  @ApiOkResponse({ description: '{ value } or 400 { message }' })
  evaluate(
    @Body(new ZodValidationPipe(evaluateSchema)) dto: EvaluateExpressionDto,
  ): { value: unknown } {
    try {
      const value = resolveParameter(dto.expression, {
        json: dto.json as JsonObject,
        binary: dto.binary as Record<string, BinaryRef> | undefined,
        itemIndex: dto.itemIndex,
        nodeOutput: (name) =>
          dto.nodes[name]?.map((json): Item => ({ json: json as JsonObject })),
      });
      return { value: value ?? null };
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }
}

@Module({ controllers: [ExpressionsController] })
export class ExpressionsModule {}
