import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SendMagicLinkDto } from './dto/dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  async sendMagicLink(@Body() dto: SendMagicLinkDto) {
    await this.authService.sendMagicLinkActor(dto.email);
    return { sent: true };
  }
}
