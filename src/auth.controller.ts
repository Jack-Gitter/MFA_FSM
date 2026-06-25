import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SendMagicLinkDto, SendMagicLinkResponse } from './dto/dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  @ApiOperation({ summary: 'Send a magic link to the provided email' })
  @ApiResponse({ status: 201, type: SendMagicLinkResponse })
  async sendMagicLink(
    @Body() dto: SendMagicLinkDto,
  ): Promise<SendMagicLinkResponse> {
    const { sessionId } = await this.authService.sendMagicLink(dto.email);
    return { sessionId };
  }
}
