import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  EnrollPhoneDto,
  SendMagicLinkDto,
  SendMagicLinkResponse,
} from './dto/dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response, Request } from 'express';
import { join } from 'path';

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
  async authenticate(
    @Query('token') token: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const sessionId = req.cookies['sessionId'];
    const { hasPhone } = await this.authService.handleMagicLink({
      sessionId,
      token,
    });

    if (hasPhone) {
      res.redirect('/auth/otp');
    } else {
      res.redirect('/auth/enroll-phone');
    }
  }

  @Post('enroll-phone')
  async enrollPhone(
    @Body() dto: EnrollPhoneDto,
    @Req() req: any,
  ): Promise<void> {
    const sessionId = req.cookies['sessionId'];
    await this.authService.enrollPhone({
      sessionId,
      phoneNumber: dto.phoneNumber,
    });
  }

  @Get('otp')
  async otpPage(@Res() res: Response): Promise<void> {
    res.sendFile(join(process.cwd(), 'public', 'otp.html'));
  }

  @Get('enroll-phone')
  async enrollPhonePage(@Res() res: Response): Promise<void> {
    res.sendFile(join(process.cwd(), 'public', 'enroll-phone.html'));
  }
}
