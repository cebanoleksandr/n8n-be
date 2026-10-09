import {
  All,
  Body,
  Controller,
  Delete,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExcludeController,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { normalizeWebhookPath } from '../../nodes/core/webhook.node.js';
import { Auth, MinRole, Public } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/roles.js';
import { BinaryDataModule } from '../binary-data/binary-data.module.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { TestWebhooksService } from './test-webhooks.service.js';
import { WebhookDispatcher } from './webhook-dispatcher.service.js';

function pathOf(param: string | string[]): string | null {
  return normalizeWebhookPath(Array.isArray(param) ? param.join('/') : param);
}

/** Public entry point for active Webhook trigger nodes: ANY /webhook/<path>. */
@ApiExcludeController()
@Public()
@Controller('webhook')
export class WebhooksController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  @All('*path')
  async handle(
    @Param('path') pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const path = pathOf(pathParam);
    const webhook = path
      ? await this.triggers.findWebhook(req.method, path)
      : null;
    if (!webhook || !path) {
      res.status(404).json({
        message: `No active webhook for ${req.method} /webhook/${path ?? ''}`,
      });
      return;
    }
    await this.dispatcher.dispatch(
      req,
      res,
      {
        workspaceId: webhook.workflow!.workspaceId,
        workflowId: webhook.workflowId,
        nodeId: webhook.nodeId,
        responseMode: webhook.responseMode,
      },
      path,
      'webhook',
    );
  }
}

/** ANY /webhook-test/<path>: one request per "listen" from the editor. */
@ApiExcludeController()
@Public()
@Controller('webhook-test')
export class TestWebhookReceiverController {
  constructor(
    private readonly testWebhooks: TestWebhooksService,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  @All('*path')
  async handle(
    @Param('path') pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const path = pathOf(pathParam);
    const target = path
      ? await this.testWebhooks.claim(req.method, path)
      : null;
    if (!target || !path) {
      res.status(404).json({
        message: `Nothing is listening on ${req.method} /webhook-test/${path ?? ''}: click "Listen" in the editor first`,
      });
      return;
    }
    // Manual mode: pinned data applies and error workflows are not triggered.
    await this.dispatcher.dispatch(req, res, target, path, 'manual');
  }
}

const listenSchema = z.object({ nodeId: z.string().optional() });

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows/:id/test-webhook')
export class TestWebhooksController {
  constructor(private readonly testWebhooks: TestWebhooksService) {}

  /** Start listening on /webhook-test/<path> for the saved workflow's Webhook nodes. */
  @Post()
  @MinRole('editor')
  @HttpCode(200)
  @ApiBody({
    required: false,
    schema: { properties: { nodeId: { type: 'string' } } },
  })
  listen(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(listenSchema.default({})))
    dto: { nodeId?: string },
  ) {
    return this.testWebhooks.listen(auth.workspaceId, id, dto.nodeId);
  }

  @Delete()
  @MinRole('editor')
  @HttpCode(204)
  stop(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.testWebhooks.stop(auth.workspaceId, id);
  }
}

@Module({
  imports: [
    ExecutionsModule,
    TriggersModule,
    BinaryDataModule,
    WorkflowsModule,
  ],
  controllers: [
    WebhooksController,
    TestWebhookReceiverController,
    TestWebhooksController,
  ],
  providers: [WebhookDispatcher, TestWebhooksService],
})
export class WebhooksModule {}
