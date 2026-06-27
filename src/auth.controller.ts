import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SendMagicLinkDto, SendMagicLinkResponse } from './dto/dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response, Request } from 'express';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  @ApiOperation({ summary: 'Send a magic link to the provided email' })
  @ApiResponse({ status: 201, type: SendMagicLinkResponse })
  async sendMagicLink(
    @Body() dto: SendMagicLinkDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendMagicLinkResponse> {
    const result = await this.authService.sendMagicLink(dto.email);

    res.cookie('sessionId', result.sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });

    return result;
  }

  @Get()
  @ApiOperation({ summary: 'Handle magic link callback' })
  async authenticate(
    @Query('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sessionId = req.cookies['sessionId'];
    await this.authService.handleMagicLink({ sessionId, token });
    res.redirect(`http://localhost:8080/otp`);
  }
}
