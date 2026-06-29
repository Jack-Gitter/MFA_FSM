import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  EnrollPhoneDto,
  SendMagicLinkDto,
  SendMagicLinkResponse,
  SubmitOtpDto,
} from './dto/dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { join } from 'path';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  async authPage(@Res() res: Response): Promise<void> {
    res.sendFile(join(process.cwd(), 'public', 'email-input.html'));
  }

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
      secure: false,
      sameSite: 'lax',
    });
    return result;
  }

  @Get('magic-link')
  async authenticate(
    @Query('token') token: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const sessionId = req.cookies['sessionId'];
    this.authService.handleMagicLink({ sessionId, token }); // no await
    res.redirect('/auth/verify');
  }

  @Get('verify')
  async verifyPage(@Req() req: any, @Res() res: Response): Promise<void> {
    const sessionId = req.cookies['sessionId'];

    if (!sessionId) return res.redirect('/auth');

    const state = this.authService.getSessionState(sessionId);

    if (!state) return res.redirect('/auth');

    if (state.matches({ processing_sms_otp: 'waiting' })) {
      return res.sendFile(join(process.cwd(), 'public', 'otp.html'));
    }

    if (state.matches({ processing_phone_enrollment: 'waiting' })) {
      return res.sendFile(join(process.cwd(), 'public', 'enroll-phone.html'));
    }

    if (state.matches('complete')) {
      return res.sendFile(join(process.cwd(), 'public', 'complete.html'));
    }

    if (state.matches('error')) {
      return res.sendFile(join(process.cwd(), 'public', 'error.html'));
    }

    // still processing, return loading page
    return res.sendFile(join(process.cwd(), 'public', 'loading.html'));
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

  @Post('otp')
  async submitOtp(@Body() dto: SubmitOtpDto, @Req() req: any): Promise<void> {
    const sessionId = req.cookies['sessionId'];
    await this.authService.submitOtp({ sessionId, code: dto.code });
  }

  @Get('session')
  async getSession(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ sessionToken: string }> {
    const sessionId = req.cookies['sessionId'];
    const sessionToken = await this.authService.getSessionToken(sessionId);
    res.cookie('stytchSession', sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    });
    return { sessionToken };
  }
}
