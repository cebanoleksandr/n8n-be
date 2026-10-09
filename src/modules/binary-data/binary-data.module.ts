import {
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { BinaryData } from './binary-data.entity.js';
import { BinaryDataService } from './binary-data.service.js';

@ApiTags('binary-data')
@Controller('binary-data')
export class BinaryDataController {
  constructor(private readonly service: BinaryDataService) {}

  /** Serves a file referenced by item.binary[...].id. */
  @Get(':id')
  @ApiProduces('application/octet-stream')
  @ApiQuery({
    name: 'download',
    required: false,
    description: 'true: attachment',
  })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, body } = await this.service.download(id);
    const name = encodeURIComponent(file.fileName ?? file.id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      `${download === 'true' ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
    );
    // Stored files are user content: never let the browser sniff or run them.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([BinaryData])],
  controllers: [BinaryDataController],
  providers: [BinaryDataService],
  exports: [BinaryDataService],
})
export class BinaryDataModule {}
