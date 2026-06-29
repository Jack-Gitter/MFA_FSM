import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
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
    // Non-blocking: fire the event and let the frontend poll for the result.
    this.authService.handleMagicLink({ sessionId, token });
    res.redirect('/auth/verify');
  }

  @Get('status')
  @ApiOperation({ summary: 'Poll the current FSM state for this session' })
  async status(@Req() req: any): Promise<{ state: string | null }> {
    const sessionId = req.cookies['sessionId'];
    if (!sessionId) return { state: null };
    const status = await this.authService.getStatus(sessionId);
    return { state: status?.state ?? null };
  }

  @Get('verify')
  async verifyPage(@Req() req: any, @Res() res: Response): Promise<void> {
    const sessionId = req.cookies['sessionId'];

    if (!sessionId) {
      return res.redirect('/auth');
    }

    const status = await this.authService.getStatus(sessionId);

    if (!status) {
      return res.redirect('/auth');
    }

    switch (status.state) {
      case 'processing_phone_enrollment':
        return res.sendFile(join(process.cwd(), 'public', 'enroll-phone.html'));
      case 'processing_sms_otp':
        return res.sendFile(join(process.cwd(), 'public', 'otp.html'));
      case 'complete':
        if (status.sessionToken) {
          res.cookie('stytchSession', status.sessionToken, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
          });
        }
        return res.sendFile(join(process.cwd(), 'public', 'complete.html'));
      case 'error':
        return res.sendFile(join(process.cwd(), 'public', 'error.html'));
      default:
        // send_magic_link, processing_magic_link, send_sms_otp — transient.
        return res.sendFile(join(process.cwd(), 'public', 'waiting.html'));
    }
  }

  @Post('enroll-phone')
  @HttpCode(202)
  async enrollPhone(
    @Body() dto: EnrollPhoneDto,
    @Req() req: any,
  ): Promise<{ accepted: true }> {
    const sessionId = req.cookies['sessionId'];
    this.authService.enrollPhone({ sessionId, phoneNumber: dto.phoneNumber });
    return { accepted: true };
  }

  @Post('otp')
  @HttpCode(202)
  async submitOtp(
    @Body() dto: SubmitOtpDto,
    @Req() req: any,
  ): Promise<{ accepted: true }> {
    const sessionId = req.cookies['sessionId'];
    this.authService.submitOtp({ sessionId, code: dto.code });
    return { accepted: true };
  }
}
